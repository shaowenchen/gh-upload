VERSION         = latest
BIN             = ./bin/app
NOW             = $(shell date -u '+%Y%m%d%I%M%S')
GIT_COUNT       = $(shell git rev-list --all --count)
GIT_HASH        = $(shell git rev-parse --short HEAD)
RELEASE_TAG     = $(VERSION).$(GIT_COUNT).$(GIT_HASH)
IMAGE_NAME      = shaowenchen/gh-upload:${VERSION}

format:
	go fmt $(go list ./... | grep -v /vendor/)
	go mod tidy
	go mod vendor

build-web:
	cd web && npm i && npm run build

run:
	go run main.go -c default.toml

build:
	go build -ldflags "-w -s -X main.VERSION=$(RELEASE_TAG) -X main.BUILD_DATE=$(NOW)" -o $(BIN) ./main.go

image:
	docker build -t ${IMAGE_NAME} -f ./Dockerfile .

container:
	docker run -it --rm -p 80:80 ${IMAGE_NAME}

push:
	docker push ${IMAGE_NAME}

clear:
	rm -rf ./bin/*
