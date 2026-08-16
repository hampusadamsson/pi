FROM node:22-slim

# Install system deps
RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install pi globally
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Config directory
ENV PI_CODING_AGENT_DIR=/root/.pi/agent

# Web UI port
EXPOSE 4242

ENTRYPOINT ["pi"]
