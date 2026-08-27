FROM node:20-alpine
WORKDIR /app
COPY server.js ./
RUN npm install ws@8.21.3 yjs@13.6.32 y-websocket@1.5.4
EXPOSE 4444
ENV PORT=4444
ENV DB_DIR=/app/data
CMD ["node", "server.js"]
