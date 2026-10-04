# Build stage
FROM node:22-slim as build
WORKDIR /usr/src/app

COPY . ./

RUN npm install
RUN npm install typescript -g
RUN npm run build

# Final stage
FROM node:22-slim
WORKDIR /usr/src/app

# Mongoose 5.x calls util.isArray (deprecated, DEP0044) and prints the warning on first use. Only
# that code is silenced; the real fix is upgrading Mongoose, which changes query behaviour across
# the whole service and is tracked separately.
ENV NODE_OPTIONS=--disable-warning=DEP0044

COPY --from=build /usr/src/app/package*.json ./
RUN npm install --production

COPY --from=build /usr/src/app/bin /usr/src/app

EXPOSE 3000

CMD ["node","server.js"]
