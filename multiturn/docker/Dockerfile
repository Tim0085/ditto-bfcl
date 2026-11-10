# Runtime manifest reference. scripts/docker-build.ts uses only local create/cp/commit.
ARG NODE_IMAGE
ARG PYTHON_IMAGE
FROM ${NODE_IMAGE} AS node_runtime
FROM ${PYTHON_IMAGE}
ARG CONTEXT
LABEL sec1.owner=ditto-sec1-bfcl sec1.context=${CONTEXT}
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY package.json ./
COPY node_modules ./node_modules
COPY vendor ./vendor
COPY data ./data
COPY config ./config
COPY src ./src
COPY scripts ./scripts
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/app/vendor/python BFCL_PYTHON=python3
USER 1000:1000
ENTRYPOINT []
CMD ["python3", "-B", "scripts/docker-entry.py", "--help"]
LABEL sec1.complete=true
