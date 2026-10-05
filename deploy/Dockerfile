FROM oven/bun:1-slim
WORKDIR /app
COPY package.json bun.lock ./
COPY server ./server
COPY index.html ./index.html
ENV PORT=8770 HOST=0.0.0.0
EXPOSE 8770
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD bun -e "const r=await fetch('http://127.0.0.1:'+(process.env.PORT||8770)+'/healthz');if(!(await r.json()).ok)process.exit(1)" || exit 1
CMD ["bun", "server/index.js"]
