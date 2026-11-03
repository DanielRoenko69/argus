FROM node:20-alpine

WORKDIR /app
COPY server.mjs ./server.mjs

USER node
EXPOSE 8787

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=20 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
