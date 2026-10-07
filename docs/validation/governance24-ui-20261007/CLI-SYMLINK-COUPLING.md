# Isolated service symlink entry correction

The parent's production cold proof found an HTTP502 before the first header: the new unit invoked the server beneath its `current` directory symlink, while Node's module URL resolved to the immutable release. The entry guard compared unresolved argv against resolved module URL, so the process exited without listening. The old read/product services use separate runtime paths and are unchanged.

The new service now compares `realpathSync` of both entry paths. A new actual child-process test creates a temporary `current` directory symlink, starts the real CLI with an independently allocated loopback port and the exact reviewed anchor, waits for its listening signal and confirms405/404 responses from its real routes. Both configured upstreams are closed loopback dummy ports; these local GET checks contact neither upstream and send no transaction. The child and temporary symlink are cleaned up.

All ten new service tests pass (`cli-symlink-tests.log`), including the actual symlink startup, scoped canonical logs, route/method refusals and bounded limits. This correction changes only the new service entry detection. No production service, systemd/nginx configuration, RPC or wallet was operated by this agent.
