/**
 * Browser client for the `sshConnection` Typert Remote namespace.
 */
export class SshConnectionApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SshConnectionApiError";
    this.code = code;
  }
}

export class SshConnectionApi {
  /** @param {() => object|undefined} getNamespace */
  constructor(getNamespace) {
    this.getNamespace = getNamespace;
  }

  async call(method, args) {
    const namespace = this.getNamespace();
    const fn = namespace?.[method];
    if (typeof fn !== "function") {
      throw new SshConnectionApiError("not-mounted", `sshConnection Remote method "${method}" is not mounted`);
    }
    const rpc = await fn(args);
    if (!rpc.ok) {
      throw new SshConnectionApiError("rpc-failed", rpc.error?.message ?? "remote call failed");
    }
    const business = rpc.value;
    if (business.ok) return business.value;
    throw new SshConnectionApiError(business.error.code, business.error.message);
  }

  list() {
    return this.call("list", {});
  }

  connect(input) {
    return this.call("connect", input);
  }

  disconnect(connectionId) {
    return this.call("disconnect", { connectionId });
  }

  setActive(connectionId) {
    return this.call("setActive", { connectionId });
  }

  profileList() {
    return this.call("profileList", {});
  }

  profileSave(input) {
    return this.call("profileSave", input);
  }

  profileDelete(profileId) {
    return this.call("profileDelete", { profileId });
  }

  profileConnect(profileId) {
    return this.call("profileConnect", { profileId });
  }

  groupList() {
    return this.call("groupList", {});
  }

  groupSave(input) {
    return this.call("groupSave", input);
  }

  groupDelete(groupId) {
    return this.call("groupDelete", { groupId });
  }
}

export function createSshConnectionApi(ctx) {
  return new SshConnectionApi(() => {
    const remote = ctx.remote;
    return remote?.namespaces?.get("sshConnection")?.service;
  });
}
