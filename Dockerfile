FROM node:22-slim

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent && \
    pi update --all

ENV HOME=/root
WORKDIR /root/.pi/agent

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

ENV PI_WEBUI_HOST=0.0.0.0
ENV PI_WEBUI_PORT=4242
ENV OPENCODE_API_KEY=""
EXPOSE 4242

WORKDIR /workspace
CMD ["pi"]
