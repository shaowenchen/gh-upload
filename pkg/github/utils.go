package github

import (
	"fmt"
	"io/ioutil"
	"os"
	"strings"
	"time"
)

func genetateFilename(filepath string) (origin string, newname string) {
	origin = strings.Split(filepath, "/")[len(strings.Split(filepath, "/"))-1]
	newname = fmt.Sprintf("%d-", time.Now().Unix()) + origin
	return origin, newname
}

func readFile(filepath string) []byte {
	file, err := os.Open(filepath)
	if err != nil {
		panic(err)
	}
	defer file.Close()
	content, err := ioutil.ReadAll(file)
	if err != nil {
		fmt.Println(err)
		return nil
	}
	os.Remove(filepath)
	return content
}
