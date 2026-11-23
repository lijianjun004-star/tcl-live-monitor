# CloudBase 云托管：淘宝直播风控对照测试（真实 Google Chrome，有头模式跑在 Xvfb 上）。
# 构建拉不到 Docker Hub 时，把 BASE_IMAGE 改为 mirror.ccs.tencentyun.com/library/python:3.11-slim-bookworm。
ARG BASE_IMAGE=python:3.11-slim-bookworm
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_INDEX_URL=https://mirrors.cloud.tencent.com/pypi/simple \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PORT=8080

# Debian 软件源换成腾讯云镜像；Chrome 优先用 vendor/ 里预先放好的安装包，没有才从 dl.google.com 下载。
COPY vendor/ /tmp/vendor/
RUN sed -i 's#http://deb.debian.org#https://mirrors.cloud.tencent.com#g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget xvfb xauth fonts-noto-cjk \
 && deb=/tmp/vendor/google-chrome-stable_current_amd64.deb \
 && if [ ! -f "$deb" ]; then wget -q -O "$deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb; fi \
 && apt-get install -y --no-install-recommends "$deb" \
 && rm -rf /tmp/vendor /var/lib/apt/lists/* \
 && google-chrome --version

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY probe_core.py probe_server.py control.html ./
RUN useradd --create-home probe && mkdir -p /tmp/probe-shots && chown probe /tmp/probe-shots
USER probe

EXPOSE 8080
CMD ["xvfb-run", "-a", "-s", "-screen 0 1366x900x24", "python", "probe_server.py"]
