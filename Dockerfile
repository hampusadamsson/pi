FROM node:22-slim

# git: required by pi package manager for git: packages and npm git deps.
# curl: required by the uv installer below.
# ripgrep + bubblewrap: required by the pi-sandbox extension (sandbox.json).
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates curl ripgrep bubblewrap && \
    rm -rf /var/lib/apt/lists/*

# uv/uvx: required by MCP servers declared in mcp.json (atlassian uses `uvx`).
# RUN curl -LsSf https://astral.sh/uv/install.sh | sh

ENV HOME=/root
ENV PATH="/root/.local/bin:${PATH}"

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

WORKDIR /root/.pi/agent

# settings.json must be present before `pi update --all` so packages
# (e.g. npm:@hypabolic/pi-hypa, which registers hypa_* tools used by roles.json)
# are installed into the image.
COPY settings.json ./settings.json
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

ENV PI_WEBUI_HOST=0.0.0.0
ENV PI_WEBUI_PORT=4242
ENV OPENCODE_API_KEY=""
EXPOSE 4242

WORKDIR /workspace
CMD ["pi"]
