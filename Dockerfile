FROM node:26.12.1-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:26.12.1-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
COPY db ./db
COPY seeds/builtin ./seeds/builtin
EXPOSE 3000
CMD ["node", "server/index.js"]
LABEL org.opencontainers.image.source=https://github.com/JeLuF/grafonaut
