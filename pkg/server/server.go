package server

import (
	"fmt"
	"net/http"
	"path/filepath"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/shaowenchen/gh-upload/pkg/github"
)

func PostFiles(c *gin.Context) {
	file, err := c.FormFile("file")
	if err != nil {
		c.String(http.StatusBadRequest, fmt.Sprintf("get form err: %s", err.Error()))
		return
	}
	basePath := "./"
	filename := basePath + filepath.Base(file.Filename)
	if err := c.SaveUploadedFile(file, filename); err != nil {
		c.String(http.StatusBadRequest, fmt.Sprintf("upload file err: %s", err.Error()))
		return
	}
	download_url := github.NewGithubClient(GlobalConfig.Github).SaveToRepo(GlobalConfig.Github, filename, nil)
	if download_url == "" {
		ShowError(c, "upload file err")
		return
	}
	if len(GlobalConfig.Server.DownloadURLS) > 0 {
		download_url = fmt.Sprintf("https://%s/%s", GlobalConfig.Server.DownloadURLS[0], download_url)
	}
	ShowData(c, PostFilesResponse{DownloadURL: download_url})
}

func GetFiles(c *gin.Context) {
	client := github.NewGithubClient(GlobalConfig.Github)
	repo := client.GetAvaliabelRepo(GlobalConfig.Github)
	files := client.GetRepoFileList(repo)

	var respFiles RespFileSlice
	for _, file := range files {
		timeStamp, filename := splitTime(*file.Name)
		respFiles = append(respFiles, RespFile{
			Size:        file.Size,
			Name:        &filename,
			TimeStamp:   timeStamp,
			DownloadURL: strings.ReplaceAll(*file.DownloadURL, "raw.githubusercontent.com", GlobalConfig.Server.DownloadURLS[0]),
		})
	}
	sort.Sort(respFiles)
	ShowData(c, GetFilesResponse{List: respFiles})
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
