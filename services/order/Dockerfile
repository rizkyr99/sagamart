# syntax=docker/dockerfile:1
# Build context is the repository root (the build generates Java from contracts/proto):
#   docker build -f services/order/Dockerfile .
FROM eclipse-temurin:25-jdk AS build
WORKDIR /src/services/order

COPY contracts/proto /src/contracts/proto
COPY services/order/mvnw services/order/pom.xml ./
COPY services/order/.mvn .mvn
COPY services/order/src src
# Tests, Spotless and Checkstyle run in CI (`./mvnw verify`); the image build only packages.
RUN --mount=type=cache,target=/root/.m2 \
    ./mvnw -B -q package -DskipTests -Dspotless.check.skip -Dcheckstyle.skip && \
    java -Djarmode=tools -jar target/order.jar extract --destination /out

FROM eclipse-temurin:25-jre
COPY --from=build /out /app
USER 10001:10001
EXPOSE 8140 9140
# The JRE image has no curl; bash's /dev/tcp is enough for a GET of /readyz.
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
    CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/${ORDER_HTTP_PORT:-8140} && printf 'GET /readyz HTTP/1.0\\r\\n\\r\\n' >&3 && head -1 <&3 | grep -q ' 200 '"]
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/order.jar"]
