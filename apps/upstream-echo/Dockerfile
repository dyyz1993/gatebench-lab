FROM golang:1.22-alpine AS build
WORKDIR /app
COPY go.mod main.go ./
RUN go build -o /upstream-echo .

FROM alpine:3.19
COPY --from=build /upstream-echo /
EXPOSE 9000
CMD ["/upstream-echo"]
