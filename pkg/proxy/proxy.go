package proxy

import (
	"net/http"
	"net/http/httputil"
	"strings"
	"github.com/gin-gonic/gin"
)

func RawProxy(c *gin.Context) {
	director := func(req *http.Request) {
		req.URL.Scheme = "https"
		req.URL.Host = "raw.githubusercontent.com"
		req.Host = "raw.githubusercontent.com"
	}
	modifyResponse := func(res *http.Response) error {
		filename := res.Request.URL.Path
		if strings.HasSuffix(filename, ".pdf") {
			res.Header.Set("content-type", "application/pdf")
			return nil
		}
		return nil
	}
	proxy := &httputil.ReverseProxy{
		Director:       director,
		ModifyResponse: modifyResponse,
	}
	proxy.ServeHTTP(c.Writer, c.Request)
}
