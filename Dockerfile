FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache tini
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --only=production
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY database/ ./database/
RUN mkdir -p /app/uploads
EXPOSE 3010
ENV PORT=3010
ENV NODE_ENV=production
VOLUME ["/app/database", "/app/uploads"]
WORKDIR /app/backend
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
