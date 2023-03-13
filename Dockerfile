FROM node:alpine AS base
LABEL org.opencontainers.image.title="gtfs-via-postgres"
LABEL org.opencontainers.image.description="Process GTFS using PostgreSQL."
LABEL org.opencontainers.image.authors="Jannis R <mail@jannisr.de>"
LABEL org.opencontainers.image.documentation="https://github.com/public-transport/gtfs-via-postgres"
LABEL org.opencontainers.image.source="https://github.com/public-transport/gtfs-via-postgres"
LABEL org.opencontainers.image.revision="4.0.0"
LABEL org.opencontainers.image.licenses="(Apache-2.0 AND Prosperity-3.0.0)"

WORKDIR /app

RUN apk add --no-cache postgresql-client

ADD package.json /app
RUN npm install --production && npm cache clean --force

ADD . /app
RUN ln -s /app/cli.js /usr/local/bin/gtfs-via-postgres

VOLUME /gtfs
WORKDIR /gtfs
ENTRYPOINT ["/app/cli.js"]

# Tag for running postgraphile script
FROM node:alpine as with-graphql
WORKDIR /app
COPY --from=base /app /app
RUN npm install \
    postgraphile@4.12 \
    @graphile-contrib/pg-simplify-inflector@^6.1 \
    @graphile/postgis@^0.2.0-0
RUN ln -s /app/scripts/run-postgraphile.js /usr/local/bin/gtfs-via-graphql
WORKDIR /gtfs
ENTRYPOINT [ "/app/scripts/run-postgraphile.js" ]

# Make sure the final exported image is just the base
FROM base