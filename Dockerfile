# Debian slim, not Alpine: the ONNX runtime behind the embedding model ships
# glibc binaries, which do not load on Alpine's musl.
FROM node:22-slim

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

# The embedding model is fetched here, at build time, so the running container
# never needs to reach the internet — and a cold start does not wait on a
# download. EMBEDDING_CACHE_DIR must match src/services/embedder.js.
ENV EMBEDDING_CACHE_DIR=/app/.models

RUN node -e "import('@huggingface/transformers').then(async ({ pipeline, env }) => { env.cacheDir = process.env.EMBEDDING_CACHE_DIR; await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' }); console.log('embedding model cached'); })"

COPY src ./src

# Product help, indexed into Qdrant at startup.
COPY knowledge ./knowledge

ENV NODE_ENV=production

EXPOSE 4007

CMD ["node", "src/server.js"]
