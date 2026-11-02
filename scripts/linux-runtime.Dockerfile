FROM node:26-bookworm AS node
FROM fedora:43
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/ /usr/local/lib/node_modules/
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
# node-pty has no Linux prebuild, so npm ci compiles it with node-gyp: python3, make and gcc-c++.
RUN dnf install -y libatomic git python3 make gcc-c++ rpm gnupg2 xorg-x11-server-Xvfb xorg-x11-xauth desktop-file-utils findutils procps-ng shadow-utils util-linux \
    && dnf clean all \
    && useradd -m -s /bin/bash tester
