# Node 22+ is required: @supabase/supabase-js v2 constructs a RealtimeClient in
# createClient() that needs a native global WebSocket (added in Node 21/22).
# On Node 20 the first Supabase Storage read throws "native WebSocket not found".
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/
COPY public/ ./public/

EXPOSE 3000

CMD ["node", "src/server.js"]
