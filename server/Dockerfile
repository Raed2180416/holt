# holt license service — single process, zero dependencies, no build step.
FROM node:22-alpine
WORKDIR /app
COPY index.mjs sign-license.mjs ./
RUN addgroup -S holt && adduser -S holt -G holt && mkdir -p /app/data && chown -R holt:holt /app
USER holt
ENV PORT=8080 HOLT_DATA=/app/data/licenses.jsonl
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"
CMD ["node", "index.mjs"]
