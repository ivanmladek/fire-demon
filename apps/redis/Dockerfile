FROM redis/redis-stack:latest

# Copy the startup script
COPY start-redis-server.sh /usr/bin/start-redis-server.sh
RUN chmod +x /usr/bin/start-redis-server.sh

# Expose Redis port
EXPOSE 6379

# Use the custom startup script as entrypoint
ENTRYPOINT ["/usr/bin/start-redis-server.sh"]
