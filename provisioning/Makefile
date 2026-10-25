export BRANCH := $(shell git branch --contains | fgrep '*' | cut -d ' ' -f 2)

.PHONY: build clean
build: isucon12-qualify mitamae.tar.gz
	packer init qualify.pkr.hcl
	packer build qualify.pkr.hcl

blackauth:
	cd ../blackauth && GOOS=linux GOARCH=amd64 go build -o ../provisioning/blackauth .

clean:
	rm -rf mitamae.tar.gz isucon12-qualify* blackauth initial_data.tar.gz

# 公開リポジトリなので gh (認証) を使わずに取得する。リポジトリ直下に取得済みならそれを使う
initial_data.tar.gz:
	if [ -f ../initial_data.tar.gz ]; then cp ../initial_data.tar.gz .; else \
		curl -fsSL https://api.github.com/repos/isucon/isucon12-qualify/releases/latest \
			| python3 -c 'import json,sys; print(json.load(sys.stdin)["assets"][0]["browser_download_url"])' \
			| xargs curl -fL -o initial_data.tar.gz; fi

isucon12-qualify:
	git clone --depth=1 --branch=$(BRANCH) https://github.com/isucon/isucon12-qualify.git
	cd isucon12-qualify/bench && GOOS=linux GOARCH=amd64 make

isucon12-qualify.tar.gz: isucon12-qualify
	cd isucon12-qualify && tar czf ../isucon12-qualify.tar.gz .

mitamae.tar.gz: initial_data.tar.gz blackauth
	install blackauth mitamae/cookbooks/blackauth/
	tar czvf mitamae.tar.gz mitamae/
