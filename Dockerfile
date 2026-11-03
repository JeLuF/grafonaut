# Debian (glibc) rather than Alpine: the canvas package (slide rendering) ships prebuilt binaries for it.
FROM node:26.12.1-trixie-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:26.12.1-trixie-slim
WORKDIR /app
ENV NODE_ENV=production
# Build information shown to admins (set by the release workflow; a local build without them shows the package version).
ARG GRAFONAUT_VERSION=
ARG GRAFONAUT_COMMIT=
ARG GRAFONAUT_COMMITTED_AT=
ENV GRAFONAUT_VERSION=$GRAFONAUT_VERSION GRAFONAUT_COMMIT=$GRAFONAUT_COMMIT GRAFONAUT_COMMITTED_AT=$GRAFONAUT_COMMITTED_AT
# Liberation fonts render slides that use Arial, Times New Roman or Courier New (same metrics); more fonts can be
# added in the seed volume (seeds/volume/fonts).
RUN apt-get update && apt-get install -y --no-install-recommends fonts-liberation && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
COPY db ./db
COPY seeds/builtin ./seeds/builtin
# When this image was built, for the build information (last, so it doesn't invalidate the cached layers above).
RUN date -u +%Y-%m-%dT%H:%M:%SZ > /app/.image-built-at
EXPOSE 3000
CMD ["node", "server/index.js"]
LABEL org.opencontainers.image.source=https://github.com/JeLuF/grafonaut
