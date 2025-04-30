package github

import (
	"context"
	"fmt"
	"log"

	"github.com/google/go-github/v43/github"
	"golang.org/x/oauth2"
)

type GithubConfig struct {
	Token       string
	DataGroup   string
	DataBranch  string
	CommitEmail string
	CommitName  string
}

var CurrentRepo string = "1"

const RepoMaxSize int = 1024 * 1024 // unit: KB

type GitHubClient struct {
	client *github.Client
	config GithubConfig
}

func NewGithubClient(config GithubConfig) *GitHubClient {
	ts := oauth2.StaticTokenSource(&oauth2.Token{AccessToken: config.Token})
	tc := oauth2.NewClient(context.TODO(), ts)
	githubClient := &GitHubClient{
		client: github.NewClient(tc),
		config: config,
	}
	return githubClient
}

func (g *GitHubClient) createRepo(name string, defaultBranch string) *github.Repository {
	privare := false
	autoinit := false
	r := &github.Repository{
		Name:          &name,
		Private:       &privare,
		Description:   nil,
		AutoInit:      &autoinit,
		DefaultBranch: &defaultBranch,
	}
	repo, _, err := g.client.Repositories.Create(
		context.TODO(),
		g.config.DataGroup,
		r,
	)
	if err != nil {
		log.Fatal(err)
	}
	return repo
}

// 返回分支大小，如果分支不存在，则创建分支
func (g *GitHubClient) GetRepoBranchSize(repo *github.Repository, branch string) int {
	_, _, err := g.client.Repositories.GetBranch(
		context.TODO(),
		g.config.DataGroup,
		repo.GetName(),
		branch,
		false,
	)
	if err == nil {
		size, _, _, err := g.client.Repositories.GetContents(
			context.TODO(),
			g.config.DataGroup,
			repo.GetName(),
			"",
			&github.RepositoryContentGetOptions{
				Ref: branch,
			})
		if err != nil {
			fmt.Println(err)
			return 0
		} else {
			return size.GetSize()
		}
	} else {
		newBranch := &github.Reference{
			Ref:    github.String("refs/heads/" + branch),
			Object: &github.GitObject{SHA: github.String(branch)},
		}
		_, _, err := g.client.Git.CreateRef(
			context.TODO(),
			g.config.DataGroup,
			repo.GetName(),
			newBranch)
		if err != nil {
			fmt.Println(err)
		} else {
			fmt.Println("create new branch success")
		}
	}
	return 0
}

func (g *GitHubClient) GetAvaliabelRepo(config GithubConfig) *github.Repository {
	opt := &github.RepositoryListByOrgOptions{
		Sort:      "created",
		Direction: "desc",
	}
	repos, _, err := g.client.Repositories.ListByOrg(context.TODO(), config.DataGroup, opt)
	if err != nil {
		fmt.Println(err)
	}
	if len(repos) > 0 && g.GetRepoBranchSize(repos[0], config.DataBranch) < RepoMaxSize {
		return repos[0]
	}
	return g.createRepo(fmt.Sprintf("cdn%d", len(repos)), config.DataBranch)
}

func (g *GitHubClient) GetRepoFileList(repo *github.Repository) []*github.RepositoryContent {
	ctx := context.Background()
	_, contents, _, err := g.client.Repositories.GetContents(
		ctx,
		g.config.DataGroup,
		repo.GetName(),
		"",
		&github.RepositoryContentGetOptions{
			Ref: g.config.DataBranch,
		})
	if err != nil {
		fmt.Println(err)
		return []*github.RepositoryContent{}
	}
	return contents
}

func (g *GitHubClient) SaveToRepo(config GithubConfig, filepath string, repo *github.Repository) string {
	ctx := context.Background()
	_, newname := genetateFilename(filepath)
	opts := &github.RepositoryContentFileOptions{
		Message: github.String(g.config.CommitName),
		Content: readFile(filepath),
		Branch:  github.String(g.config.DataBranch),
		Committer: &github.CommitAuthor{
			Name:  github.String(g.config.CommitName),
			Email: github.String(g.config.CommitEmail),
		},
	}
	latestRepo := g.GetAvaliabelRepo(config)
	fmt.Printf("current repo size: %d KB \n", latestRepo.GetSize())
	_, _, err := g.client.Repositories.CreateFile(
		ctx,
		g.config.DataGroup,
		latestRepo.GetName(),
		newname,
		opts)
	if err != nil {
		fmt.Println(err)
		return ""
	}
	return fmt.Sprintf("%s/%s/%s/%s", g.config.DataGroup, latestRepo.GetName(), g.config.DataBranch, newname)
}

func (g *GitHubClient) DeleteFile(repo *github.Repository, fileName string) error {
	ctx := context.Background()
	file, _, _, err := g.client.Repositories.GetContents(
		ctx,
		g.config.DataGroup,
		repo.GetName(),
		fileName,
		&github.RepositoryContentGetOptions{
			Ref: g.config.DataBranch,
		})
	if err != nil {
		return err
	}
	opts := &github.RepositoryContentFileOptions{
		Message: github.String("Delete file " + fileName),
		SHA:     file.SHA,
		Branch:  github.String(g.config.DataBranch),
		Committer: &github.CommitAuthor{
			Name:  github.String(g.config.CommitName),
			Email: github.String(g.config.CommitEmail),
		},
	}
	_, _, err = g.client.Repositories.DeleteFile(
		ctx,
		g.config.DataGroup,
		repo.GetName(),
		fileName,
		opts)
	return err
}

func (g *GitHubClient) ClearRepo(repo *github.Repository) error {
	ctx := context.Background()
	_, err := g.client.Repositories.Delete(
		ctx,
		g.config.DataGroup,
		repo.GetName(),
	)
	if err != nil {
		fmt.Println("Error deleting repository:", err)
		return err
	}
	fmt.Println("Repository deleted successfully")
	return nil
}
