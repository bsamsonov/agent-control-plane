# Python MCP server — RFM segment scoring (port 3104)
FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml .
RUN pip install --no-cache-dir .

COPY segment_py/ segment_py/

EXPOSE 3104

CMD ["python", "-m", "segment_py.server"]
