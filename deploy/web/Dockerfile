# Build context: a repó gyökere (docker-compose: context: ..)
FROM node:20-alpine AS build
WORKDIR /src
COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps --no-audit --no-fund
COPY public ./public
COPY src ./src
ARG REACT_APP_API_URL=/api/fusarium-api
ENV REACT_APP_API_URL=$REACT_APP_API_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/build /usr/share/nginx/html
EXPOSE 80
