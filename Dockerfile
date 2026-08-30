FROM node:22-slim

ARG PI_WEB_VERSION=latest

# git: required by pi package manager for git: packages and npm git deps.
# curl: required by PI WEB runtime checks and by the uv installer below.
# ripgrep + bubblewrap: required by the pi-sandbox extension (sandbox.json).
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates curl ripgrep bubblewrap && \
    mkdir -p /usr/share/keyrings && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

# uv/uvx: required by MCP servers declared in mcp.json (atlassian uses `uvx`).
# RUN curl -LsSf https://astral.sh/uv/install.sh | sh

ENV HOME=/root
ENV PATH="/root/.local/bin:${PATH}"
ENV PI_CODING_AGENT_DIR=/root/.pi/agent

# npm 12 is required for the scoped --allow-scripts=node-pty flag used by PI WEB.
RUN npm install -g npm@12

# Pi Coding Agent runs the sessions; PI WEB provides the web/API server and session daemon.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent && \
    npm install -g "@jmfederico/pi-web@${PI_WEB_VERSION}" --allow-scripts=node-pty && \
    npm cache clean --force

WORKDIR /root/.pi/agent

# settings.json must be present before `pi update --all` so packages
# (e.g. npm:@hypabolic/pi-hypa, which registers hypa_* tools used by roles.json)
# are installed into the image.
COPY settings.json ./settings.json
# PI WEB ships its relay Pi package inside its npm package. Point the configured
# local package path at the global install inside this image.
RUN node -e "const fs=require('fs');const p='settings.json';const s=JSON.parse(fs.readFileSync(p,'utf8'));s.packages=s.packages.map(x=>x.replace('../../../../opt/homebrew/lib/node_modules/@jmfederico/pi-web/dist/pi-packages/relays','/usr/local/lib/node_modules/@jmfederico/pi-web/dist/pi-packages/relays'));fs.writeFileSync(p,JSON.stringify(s,null,2)+'\n')"
COPY extensions ./extensions
COPY roles ./roles
COPY roles.json ./roles.json
COPY skills ./skills
COPY themes ./themes
COPY prompts ./prompts
COPY mcp.json ./mcp.json
COPY zentui.json ./zentui.json
COPY caveman.json ./caveman.json
COPY sandbox.json ./sandbox.json
COPY APPEND_SYSTEM.md ./APPEND_SYSTEM.md

RUN pi update --all

ENV PI_WEB_HOST=0.0.0.0
ENV PI_WEB_PORT=4242
ENV OPENCODE_API_KEY=""
EXPOSE 4242

# PI WEB runs a session daemon and web/API server; start both in one container.
COPY docker-entrypoint.sh /usr/local/bin/pi-web-entrypoint
RUN chmod +x /usr/local/bin/pi-web-entrypoint

WORKDIR /workspace
CMD ["pi-web-entrypoint"]
