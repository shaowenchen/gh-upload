package server

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func ShowNotLogin(c *gin.Context) {
	c.JSON(http.StatusUnauthorized, gin.H{
		"msg":  "未登录",
		"code": 0,
	})
}

func ShowError(c *gin.Context, msg string) {
	c.JSON(http.StatusOK, gin.H{
		"code": -1,
		"msg":  msg,
	})
}
func ShowValidatorError(c *gin.Context, msg interface{}) {
	c.JSON(http.StatusPreconditionFailed, gin.H{
		"code": -1,
		"msg":  msg,
	})
}

func ShowErrorParams(c *gin.Context, msg string) {
	c.JSON(http.StatusOK, gin.H{
		"code": -1,
		"msg":  msg,
	})
}

func ShowSuccess(c *gin.Context, msg string) {
	c.JSON(http.StatusOK, gin.H{
		"code": 0,
		"msg":  msg,
	})
}

func ShowData(c *gin.Context, data interface{}) {
	c.JSON(http.StatusOK, gin.H{
		"code": 0,
		"data": data,
	})
}

type PostFilesResponse struct{
	DownloadURL string `json:"download_url"`
}

type GetFilesResponse struct{
	List []RespFile `json:"list"`
}