FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Erst nur die Manifeste kopieren -> Layer-Caching für Dependencies
COPY package*.json ./

# npm install (NICHT npm ci) -> funktioniert auch ohne package-lock.json,
# genau das war ein Hauptgrund für "exit code 1" im Build.
RUN npm install --omit=dev --no-audit --no-fund

# Restlichen Code kopieren
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
