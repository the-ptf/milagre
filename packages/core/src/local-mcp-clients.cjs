const { privateJson, hash } = require("./local-mcp-store.cjs");
const { clientCatalog, readConfig, prepareEdit, clientEntry, entryToken, canonical } = require("./local-mcp-client-files.cjs");
const digest = (entry) => (entry === undefined ? null : hash(JSON.stringify(canonical(entry))));

// Only hashes and grant IDs are kept here. The issued credential lives in the client's private config.
function createLocalMcpClients({ directory, store, url, ...options }) {
  const file = privateJson(directory, "clients.json", {});
  let records = file.read();
  const catalog = clientCatalog(options);
  const problems = new Map();
  const clientFor = (id) => {
    const client = catalog.find((item) => item.id === id);
    if (!client || client.unavailable) throw Error(client?.unavailable ?? "Unknown MCP client");
    // Keep an enabled installation at its recorded path even if an environment override changes.
    return { ...client, configPath: records[id]?.configPath ?? client.configPath };
  };
  const save = (id, record) => {
    const next = { ...records, [id]: record };
    file.write(next);
    records = next;
  };
  const active = (record) => {
    try {
      return record && store.get(record.connectionId);
    } catch {
      return null;
    }
  };
  const owned = (record, entry) => entry === undefined || record?.entryHashes?.includes(digest(entry));
  const statusOf = (client) => {
    const record = records[client.id];
    const connection = active(record);
    let problem = client.unavailable ?? problems.get(client.id);
    let configured = false;
    const configPath = record?.configPath ?? client.configPath;
    try {
      const { entry } = readConfig({ ...client, configPath });
      if (record?.enabled && connection && owned(record, entry) && entry) configured = store.authenticate(entryToken(entry)).id === connection.id;
      if (entry && !owned(record, entry)) problem = "The Milagre entry was changed outside Milagre. It has been left untouched.";
    } catch {
      problem ??= "Could not read this client's configuration. Fix the file, then try again.";
    }
    return {
      id: client.id,
      label: client.label,
      configPath,
      enabled: Boolean(record?.enabled && connection),
      state: client.unavailable ? "unavailable" : problem ? "error" : configured ? "configured" : record?.enabled && connection ? "missing" : "off",
      ...(connection ? { connection } : {}),
      ...(problem ? { problem } : {}),
    };
  };
  const install = (client, made, read, previous) => {
    const entry = clientEntry(client.id, url(), made.token);
    const commit = prepareEdit(client, read, entry);
    const record = {
      enabled: true,
      connectionId: made.connection.id,
      configPath: client.configPath,
      entryHashes: [...new Set([digest(entry), digest(read.entry)].filter(Boolean))],
    };
    // Persist the intent before editing the client. A restart can reconcile either side of this write.
    save(client.id, record);
    commit();
    save(client.id, { ...record, entryHashes: [digest(entry)] });
    if (previous && previous.connectionId !== made.connection.id) store.revoke(previous.connectionId);
  };
  const disable = (id) => {
    const client = clientFor(id),
      record = records[id];
    if (!record) return statusOf(client);
    store.revoke(record.connectionId);
    save(id, { ...record, enabled: false });
    problems.delete(id);
    try {
      const read = readConfig(client);
      if (read.entry && owned(record, read.entry)) prepareEdit(client, read, undefined)();
      else if (read.entry) problems.set(id, "Access revoked. The entry changed outside Milagre and was left untouched.");
    } catch {
      problems.set(id, "Access revoked. Remove the Milagre entry from this client's configuration.");
    }
    return statusOf(client);
  };
  return {
    status: () => catalog.map(statusOf),
    manages: (connectionId) => Object.entries(records).find(([, record]) => record.connectionId === connectionId)?.[0],
    enable(id, input) {
      const client = clientFor(id),
        previous = records[id];
      const read = readConfig(client);
      if (!owned(previous, read.entry)) throw Error("Client configuration changed outside Milagre. Its entry will not be overwritten.");
      const existing = previous?.enabled ? active(previous) : null;
      const token = read.entry ? entryToken(read.entry) : null;
      let reusable = false;
      if (existing && token) {
        try {
          reusable = store.authenticate(token).id === existing.id;
        } catch {}
      }
      if (reusable) {
        const needsRefresh = digest(read.entry) !== digest(clientEntry(id, url(), token));
        if (needsRefresh) prepareEdit(client, read, clientEntry(id, url(), token));
        const connection = store.update(existing.id, input);
        problems.delete(id);
        if (needsRefresh) install(client, { connection, token }, read, previous);
        return statusOf(client);
      }
      // Validate the config layout before issuing a credential. The placeholder is never written.
      prepareEdit(client, read, clientEntry(id, url(), "x".repeat(43)));
      const made = store.create(input, { clientId: id });
      problems.delete(id);
      try {
        if (previous) store.revoke(previous.connectionId);
        install(client, made, read, previous);
      } catch {
        store.revoke(made.connection.id);
        if (records[id]?.connectionId === made.connection.id) save(id, { ...records[id], enabled: false });
        throw Error("Client setup could not be saved. Access was revoked; refresh and try again.");
      }
      return statusOf(client);
    },
    disable,
    resume() {
      // A crash between issuing a credential and saving installation intent can leave an orphan.
      for (const connection of store.list())
        if (connection.clientId && records[connection.clientId]?.connectionId !== connection.id) store.revoke(connection.id);
      for (const id of Object.keys(records)) {
        let client;
        try {
          client = clientFor(id);
          const record = records[id];
          const connection = active(record);
          if (!record.enabled || !connection) {
            disable(id);
            continue;
          }
          const read = readConfig(client);
          if (!owned(record, read.entry)) {
            problems.set(id, "The Milagre entry changed outside Milagre. Use setup to review it.");
            continue;
          }
          let authenticated = false;
          try {
            authenticated = read.entry && store.authenticate(entryToken(read.entry)).id === connection.id;
          } catch {}
          if (authenticated) {
            // App updates can move the stdio executable. Keep the credential and refresh owned paths.
            const token = entryToken(read.entry);
            if (digest(read.entry) !== digest(clientEntry(id, url(), token))) install(client, { connection, token }, read, record);
            continue;
          }
          const made = store.rotate(connection.id);
          install(client, made, read, record);
        } catch {
          if (client) problems.set(id, "Automatic setup needs attention. Open setup to reconnect this client.");
        }
      }
    },
  };
}
module.exports = { createLocalMcpClients };
