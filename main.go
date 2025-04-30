package main

import (
	"flag"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/shaowenchen/gh-upload/pkg/proxy"
	"github.com/shaowenchen/gh-upload/pkg/server"
)

func init() {
	configpath := flag.String("c", "", "")
	flag.Parse()
	server.ReadConfig(*configpath)
}

func setupRouter() *gin.Engine {
	r := gin.Default()
	// validateDomainMiddleware is a middleware to validate the domain of the request.
	validateDomainMiddleware := func() gin.HandlerFunc {
		return func(c *gin.Context) {
			requestDomain := c.Request.Host
			requestUri := c.Request.RequestURI
			if strings.HasPrefix(requestUri, "/uploadbases") && requestDomain != "localhost" && len(server.GlobalConfig.Server.DownloadURLS) > 0 && server.Contains(server.GlobalConfig.Server.DownloadURLS, requestDomain) == false {
				c.AbortWithStatus(http.StatusForbidden)
				return
			}
			c.Next()
		}
	}
	r.Use(validateDomainMiddleware())
	// allowCrossDomainMiddleware is a middleware to allow cross domain request.
	allowCrossDomainMiddleware := func(c *gin.Context) {
		method := c.Request.Method
		origin := c.Request.Header.Get("Origin")
		if origin != "" {
			c.Header("Access-Control-Allow-Origin", "*")
			c.Header("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE, UPDATE")
			c.Header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization")
			c.Header("Access-Control-Expose-Headers", "Content-Length, Access-Control-Allow-Origin, Access-Control-Allow-Headers, Cache-Control, Content-Language, Content-Type")
			c.Header("Access-Control-Allow-Credentials", "true")
		}
		if method == "OPTIONS" {
			c.AbortWithStatus(http.StatusNoContent)
		}
		c.Next()
	}
	r.Use(allowCrossDomainMiddleware)
	r.POST("/api/v1/files", server.PostFiles)
	r.GET("/api/v1/files", server.GetFiles)
	r.GET("/api/v1/clear", server.ClearFiles)
	r.GET("/api/version/", server.Version)

	apiPrefix := "/uploadbases"
	dumpParam := []string{apiPrefix, "a", "b", "c"}
	for _, item := range []int{3} {
		urlPattern := strings.Join(dumpParam[0:item+1], "/:")
		r.GET(urlPattern, proxy.RawProxy)
	}
	return r
}

func main() {
	r := setupRouter()
	r.Run(":80")
}
