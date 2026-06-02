package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/shaowenchen/gh-upload/pkg/github"
)

const largeFileChunkSize = 50 * 1024 * 1024

type ChunkManifest struct {
	Version      int                 `json:"version"`
	FileID       string              `json:"file_id"`
	OriginalName string              `json:"original_name"`
	ContentType  string              `json:"content_type"`
	Size         int64               `json:"size"`
	ChunkSize    int64               `json:"chunk_size"`
	TotalChunks  int                 `json:"total_chunks"`
	SHA256       string              `json:"sha256"`
	Chunks       []ChunkManifestPart `json:"chunks"`
	CreatedAt    int64               `json:"created_at"`
}

type ChunkManifestPart struct {
	Index  int    `json:"index"`
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

func PostFiles(c *gin.Context) {
	file, err := c.FormFile("file")
	if err != nil {
		c.String(http.StatusBadRequest, fmt.Sprintf("get form err: %s", err.Error()))
		return
	}
	// GitHub API 需要完整文件内容（base64），不支持流式上传，先暂存到本地临时文件
	tempDir := os.TempDir()
	tempPath := filepath.Join(tempDir, fmt.Sprintf("gh-upload-%d-%s", time.Now().UnixNano(), filepath.Base(file.Filename)))
	defer os.Remove(tempPath) // 上传完成后删除临时文件（成功或失败都清理）

	if err := c.SaveUploadedFile(file, tempPath); err != nil {
		c.String(http.StatusBadRequest, fmt.Sprintf("upload file err: %s", err.Error()))
		return
	}

	client := github.NewGithubClient(GlobalConfig.Github)
	download_url := ""
	originalName := sanitizeFilename(file.Filename)
	if file.Size > largeFileChunkSize {
		manifest, err := saveLargeFile(client, tempPath, originalName, file.Header.Get("Content-Type"), file.Size)
		if err != nil {
			fmt.Println(err)
			ShowError(c, "upload large file err")
			return
		}
		download_url = buildPublicURL(c, fmt.Sprintf("/api/v1/files/%s/download", manifest.FileID))
	} else {
		repoPath := fmt.Sprintf("%d-%s", time.Now().Unix(), originalName)
		download_url = client.SaveFileToRepo(GlobalConfig.Github, tempPath, repoPath)
		if download_url != "" {
			download_url = buildConfiguredRawURL(download_url)
		}
	}
	if download_url == "" {
		ShowError(c, "upload file err")
		return
	}
	ShowData(c, PostFilesResponse{DownloadURL: download_url})
}

func GetFiles(c *gin.Context) {
	client := github.NewGithubClient(GlobalConfig.Github)
	repo := client.GetAvaliabelRepo(GlobalConfig.Github)
	files := client.GetRepoFileList(repo)

	var respFiles RespFileSlice
	for _, file := range files {
		if file.Name == nil {
			continue
		}
		name := *file.Name
		if isChunkPartName(name) {
			continue
		}
		if isManifestName(name) {
			manifestBytes, err := client.GetRepoFileBytes(repo, name)
			if err != nil {
				fmt.Println(err)
				continue
			}
			var manifest ChunkManifest
			if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
				fmt.Println(err)
				continue
			}
			size := int(manifest.Size)
			respFiles = append(respFiles, RespFile{
				Size:        &size,
				Name:        &manifest.OriginalName,
				TimeStamp:   manifest.CreatedAt,
				DownloadURL: buildPublicURL(c, fmt.Sprintf("/api/v1/files/%s/download", manifest.FileID)),
			})
			continue
		}
		timeStamp, filename := splitTime(name)
		respFiles = append(respFiles, RespFile{
			Size:        file.Size,
			Name:        &filename,
			TimeStamp:   timeStamp,
			DownloadURL: buildRawDownloadURL(file.DownloadURL),
		})
	}
	sort.Sort(respFiles)
	ShowData(c, GetFilesResponse{List: respFiles})
}

func DownloadFile(c *gin.Context) {
	fileID := c.Param("id")
	if fileID == "" || strings.Contains(fileID, "/") || strings.Contains(fileID, "..") {
		c.String(http.StatusBadRequest, "invalid file id")
		return
	}

	client := github.NewGithubClient(GlobalConfig.Github)
	repo := client.GetAvaliabelRepo(GlobalConfig.Github)
	manifestBytes, err := client.GetRepoFileBytes(repo, manifestName(fileID))
	if err != nil {
		c.String(http.StatusNotFound, "file not found")
		return
	}

	var manifest ChunkManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		c.String(http.StatusInternalServerError, "invalid manifest")
		return
	}

	tempFile, err := os.CreateTemp("", "gh-upload-download-*")
	if err != nil {
		c.String(http.StatusInternalServerError, "create temp file err")
		return
	}
	tempPath := tempFile.Name()
	defer os.Remove(tempPath)
	defer tempFile.Close()

	totalHash := sha256.New()
	for _, part := range manifest.Chunks {
		content, err := client.GetRepoFileBytes(repo, part.Name)
		if err != nil {
			c.String(http.StatusInternalServerError, "download chunk err")
			return
		}
		partHash := sha256.Sum256(content)
		if hex.EncodeToString(partHash[:]) != part.SHA256 {
			c.String(http.StatusInternalServerError, "chunk checksum mismatch")
			return
		}
		if _, err := tempFile.Write(content); err != nil {
			c.String(http.StatusInternalServerError, "assemble file err")
			return
		}
		if _, err := totalHash.Write(content); err != nil {
			c.String(http.StatusInternalServerError, "hash file err")
			return
		}
	}
	if hex.EncodeToString(totalHash.Sum(nil)) != manifest.SHA256 {
		c.String(http.StatusInternalServerError, "file checksum mismatch")
		return
	}
	if _, err := tempFile.Seek(0, 0); err != nil {
		c.String(http.StatusInternalServerError, "read assembled file err")
		return
	}

	contentType := manifest.ContentType
	if contentType == "" {
		contentType = mime.TypeByExtension(filepath.Ext(manifest.OriginalName))
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", manifest.OriginalName))
	http.ServeContent(c.Writer, c.Request, manifest.OriginalName, time.Unix(manifest.CreatedAt, 0), tempFile)
}

func ClearFiles(c *gin.Context) {
	client := github.NewGithubClient(GlobalConfig.Github)
	repo := client.GetAvaliabelRepo(GlobalConfig.Github)
	err := client.ClearRepo(repo)
	if err != nil {
		ShowError(c, "Failed to clear repository")
		return
	}
	ShowData(c, gin.H{"message": "Repository cleared successfully"})
}

func Version(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"version": "1.0.0",
	})
}

func saveLargeFile(client *github.GitHubClient, filePath string, originalName string, contentType string, size int64) (*ChunkManifest, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	createdAt := time.Now().Unix()
	fileID := buildFileID(originalName, size, createdAt)
	totalChunks := int((size + largeFileChunkSize - 1) / largeFileChunkSize)
	manifest := &ChunkManifest{
		Version:      1,
		FileID:       fileID,
		OriginalName: originalName,
		ContentType:  contentType,
		Size:         size,
		ChunkSize:    largeFileChunkSize,
		TotalChunks:  totalChunks,
		Chunks:       make([]ChunkManifestPart, 0, totalChunks),
		CreatedAt:    createdAt,
	}

	totalHash := sha256.New()
	buffer := make([]byte, largeFileChunkSize)
	for index := 1; index <= totalChunks; index++ {
		n, readErr := io.ReadFull(file, buffer)
		if readErr != nil && readErr != io.EOF && readErr != io.ErrUnexpectedEOF {
			return nil, readErr
		}
		if n == 0 {
			break
		}

		chunk := make([]byte, n)
		copy(chunk, buffer[:n])
		if _, err := totalHash.Write(chunk); err != nil {
			return nil, err
		}
		chunkHash := sha256.Sum256(chunk)
		part := ChunkManifestPart{
			Index:  index,
			Name:   partName(fileID, index, totalChunks),
			Size:   int64(n),
			SHA256: hex.EncodeToString(chunkHash[:]),
		}
		if client.SaveContentToRepo(GlobalConfig.Github, part.Name, chunk) == "" {
			return nil, fmt.Errorf("upload chunk %s failed", part.Name)
		}
		manifest.Chunks = append(manifest.Chunks, part)
	}
	manifest.SHA256 = hex.EncodeToString(totalHash.Sum(nil))

	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, err
	}
	if client.SaveContentToRepo(GlobalConfig.Github, manifestName(fileID), manifestBytes) == "" {
		return nil, fmt.Errorf("upload manifest %s failed", manifestName(fileID))
	}
	return manifest, nil
}

func buildFileID(originalName string, size int64, createdAt int64) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%d:%d", originalName, size, createdAt, time.Now().UnixNano())))
	return hex.EncodeToString(sum[:])[:32]
}

func sanitizeFilename(name string) string {
	name = filepath.Base(name)
	name = strings.ReplaceAll(name, "/", "_")
	name = strings.ReplaceAll(name, "\\", "_")
	if name == "." || name == "" {
		return "file"
	}
	return name
}

func partName(fileID string, index int, total int) string {
	return fmt.Sprintf("%s.part.%06d-of-%06d", fileID, index, total)
}

func manifestName(fileID string) string {
	return fmt.Sprintf("%s.manifest.json", fileID)
}

func isChunkPartName(name string) bool {
	return strings.Contains(name, ".part.") && strings.Contains(name, "-of-")
}

func isManifestName(name string) bool {
	return strings.HasSuffix(name, ".manifest.json")
}

func buildPublicURL(c *gin.Context, path string) string {
	proto := c.GetHeader("X-Forwarded-Proto")
	if proto == "" {
		if c.Request.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	return fmt.Sprintf("%s://%s%s", proto, c.Request.Host, path)
}

func buildRawDownloadURL(downloadURL *string) string {
	if downloadURL == nil {
		return ""
	}
	return buildConfiguredRawURL(*downloadURL)
}

func buildConfiguredRawURL(downloadURL string) string {
	if len(GlobalConfig.Server.DownloadURLS) == 0 || GlobalConfig.Server.DownloadURLS[0] == "" {
		if strings.HasPrefix(downloadURL, "http://") || strings.HasPrefix(downloadURL, "https://") {
			return downloadURL
		}
		return fmt.Sprintf("https://raw.githubusercontent.com/%s", downloadURL)
	}
	if strings.HasPrefix(downloadURL, "http://") || strings.HasPrefix(downloadURL, "https://") {
		return strings.ReplaceAll(downloadURL, "raw.githubusercontent.com", GlobalConfig.Server.DownloadURLS[0])
	}
	return fmt.Sprintf("https://%s/%s", GlobalConfig.Server.DownloadURLS[0], downloadURL)
}
