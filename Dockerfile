FROM node:20-alpine
WORKDIR /app
COPY server.js ./
RUN npm install ws@8.21.3 yjs@13.6.32 y-websocket@1.5.4
EXPOSE 4444
ENV PORT=4444
ENV DB_DIR=/app/data
# Set LAPLAS_COWORK_SECRET at runtime; server.js refuses unauthenticated startup.
CMD ["node", "server.js"]
