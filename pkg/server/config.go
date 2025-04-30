package server

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/shaowenchen/gh-upload/pkg/github"
	"github.com/spf13/viper"
)

var GlobalConfig = Config{}

func initViper(configPath string) {
	path, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	if configPath == "" {
		viper.SetConfigName("default")
		viper.SetConfigType("toml")
	} else {
		viper.SetConfigFile(configPath)
	}
	viper.AddConfigPath(filepath.Join(path, "."))
	viper.AutomaticEnv()
	viper.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))

	err = viper.ReadInConfig()
	if err != nil {
		fmt.Printf("fatal error config file: %s \n", err)
	}
}

// read config file and set default value
func ReadConfig(configPath string) {
	initViper(configPath)
	GlobalConfig = Config{}
	viper.SetDefault("gin.runmode", "debug")
	GlobalConfig.Gin.RunMode = viper.GetString("gin.runmode")
	viper.SetDefault("server.download_urls", "")
	GlobalConfig.Server.DownloadURLS = strings.Split(viper.GetString("server.download_urls"), ",")
	viper.SetDefault("github.token", "")
	GlobalConfig.Github.Token = viper.GetString("github.token")
	viper.SetDefault("github.datagroup", "uploadbases")
	GlobalConfig.Github.DataGroup = viper.GetString("github.datagroup")
	viper.SetDefault("github.databranch", "raw")
	GlobalConfig.Github.DataBranch = viper.GetString("github.databranch")
	viper.SetDefault("github.commitemail", "auto@auto.com")
	GlobalConfig.Github.CommitEmail = viper.GetString("github.commitemail")
	viper.SetDefault("github.commitname", "none")
	GlobalConfig.Github.CommitName = viper.GetString("github.commitname")
}

type Config struct {
	Gin    GinConfig
	Server ServerConfig
	Github github.GithubConfig
}

type GinConfig struct {
	RunMode string
}

type ServerConfig struct {
	DownloadURLS []string
}
