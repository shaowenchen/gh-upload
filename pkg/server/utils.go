package server

import (
	"strconv"
	"strings"
)

type RespFile struct {
	Size        *int    `json:"size,omitempty"`
	Name        *string `json:"name,omitempty"`
	TimeStamp   int64   `json:"timestamp,omitempty"`
	DownloadURL string  `json:"download_url,omitempty"`
}

// 实现切片排序接口
type RespFileSlice []RespFile

func (p RespFileSlice) Len() int {
	return len(p)
}

// 降序
func (p RespFileSlice) Less(i, j int) bool {
	return p[i].TimeStamp > p[j].TimeStamp
}

func (p RespFileSlice) Swap(i, j int) {
	p[i], p[j] = p[j], p[i]
}

func splitTime(str string) (int64, string) {
	index := strings.Index(str, "-")
	if index == -1 {
		return 0, str
	}
	createTime, _ := strconv.ParseInt(str[:index], 10, 64)
	return createTime, str[index+1:]
}

func Contains(arr []string, str string) bool {
	for _, a := range arr {
		if a == str {
			return true
		}
	}
	return false
}
