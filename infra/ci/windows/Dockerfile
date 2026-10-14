ARG BASE_IMAGE=ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
FROM ${BASE_IMAGE}
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3 python3-libvirt openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY vm-supervisor.py /opt/t3-ci/vm-supervisor.py
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["/usr/bin/python3", "/opt/t3-ci/vm-supervisor.py"]
