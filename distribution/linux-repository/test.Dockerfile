# Local real-tool verification only; this image is never deployed.
FROM node:26-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    gnupg dpkg-dev rpm createrepo-c apt-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
