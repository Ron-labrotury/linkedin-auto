# One image that serves the API, the automation engine (headless Chromium) and the built frontend.
# Deploy on any Docker host with a persistent volume mounted at /data (Render, Railway, Fly.io, a VPS…).
# Give it at least 1 GB of memory: every connected LinkedIn account uses a Chromium tab.

FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY shared ./shared
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci
COPY frontend ./frontend
# Same-origin API: leave VITE_API_URL empty.
RUN cd frontend && npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm
COPY shared ./shared
COPY backend/src ./backend/src
COPY --from=web /app/frontend/dist ./frontend/dist
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "backend/src/index.ts"]
