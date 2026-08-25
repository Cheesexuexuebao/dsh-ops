/**
 * Host typert artifact: discovered automatically by @deepseek-ai/dsh-typert-loader
 * through the package's "./typert" export and registered into ctx.typert, which
 * the typert gateway consults for strict dispatch codecs.
 */
import { DESCRIPTORS } from "./descriptors.js";
import { sshErrorSchema } from "./schemas.js";

export const TYPERT = {
  package: "dsh-ssh-connection",
  face: "host",
  schemas: [
    { name: "sshError", schema: sshErrorSchema }
  ],
  invocations: DESCRIPTORS,
  model: {
    events: [],
    objects: [],
    services: [
      {
        description: "SSH connection and saved resources for the Web UI: connect to remote hosts, list live transports, and manage profile/group inventory. Backed by ssh2 in the host process.",
        summary: "SSH connections and saved resources backed by ssh2.",
        tags: [],
        jsDoc: "/**\n * SSH connections and saved resources for the Web UI.\n */",
        key: "sshConnection",
        exportName: "SshConnectionService",
        members: [
          { kind: "method", name: "list", signature: "async list(request: SshListRequest): Promise<SshListResult>" },
          { kind: "method", name: "connect", signature: "async connect(request: SshConnectRequest): Promise<SshConnectResult>" },
          { kind: "method", name: "profileList", signature: "async profileList(request: SshProfileListRequest): Promise<SshProfileListResult>" },
          { kind: "method", name: "profileSave", signature: "async profileSave(request: SshProfileSaveRequest): Promise<SshProfileSaveResult>" },
          { kind: "method", name: "profileDelete", signature: "async profileDelete(request: SshProfileDeleteRequest): Promise<SshProfileDeleteResult>" },
          { kind: "method", name: "profileConnect", signature: "async profileConnect(request: SshProfileConnectRequest): Promise<SshProfileConnectResult>" },
          { kind: "method", name: "groupList", signature: "async groupList(request: SshGroupListRequest): Promise<SshGroupListResult>" },
          { kind: "method", name: "groupSave", signature: "async groupSave(request: SshGroupSaveRequest): Promise<SshGroupSaveResult>" },
          { kind: "method", name: "groupDelete", signature: "async groupDelete(request: SshGroupDeleteRequest): Promise<SshGroupDeleteResult>" },
          { kind: "method", name: "disconnect", signature: "async disconnect(request: SshDisconnectRequest): Promise<SshDisconnectResult>" },
          { kind: "method", name: "setActive", signature: "async setActive(request: SshSetActiveRequest): Promise<SshSetActiveResult>" }
        ],
        types: [
          { name: "SshListRequest", declaration: "export interface SshListRequest {}" },
          { name: "SshListResult", declaration: "export type SshListResult = SshResult<{ connections: SshConnectionInfo[]; activeConnectionId: string | null }>;" },
          { name: "SshConnectRequest", declaration: "export interface SshConnectRequest { readonly host: string; readonly port?: number; readonly username: string; readonly auth: SshAuth; readonly readyTimeout?: number; readonly name?: string; }" },
          { name: "SshConnectResult", declaration: "export type SshConnectResult = SshResult<{ connectionId: string; name?: string; host: string; port: number; username: string }>;" },
          { name: "SshProfileListRequest", declaration: "export interface SshProfileListRequest {}" },
          { name: "SshProfileListResult", declaration: "export type SshProfileListResult = SshResult<{ profiles: SshProfileInfo[] }>;" },
          { name: "SshProfileSaveRequest", declaration: "export interface SshProfileSaveRequest { readonly profileId?: string; readonly name: string; readonly host: string; readonly port?: number; readonly username: string; readonly authKind: 'password' | 'key'; readonly groupId?: string | null; }" },
          { name: "SshProfileSaveResult", declaration: "export type SshProfileSaveResult = SshResult<{ profile: SshProfileInfo; credentialRefs: SshCredentialRefs }>;" },
          { name: "SshProfileDeleteRequest", declaration: "export interface SshProfileDeleteRequest { readonly profileId: string; }" },
          { name: "SshProfileDeleteResult", declaration: "export type SshProfileDeleteResult = SshResult<{ deleted: boolean }>;" },
          { name: "SshProfileConnectRequest", declaration: "export interface SshProfileConnectRequest { readonly profileId: string; }" },
          { name: "SshProfileConnectResult", declaration: "export type SshProfileConnectResult = SshConnectResult;" },
          { name: "SshGroupListRequest", declaration: "export interface SshGroupListRequest {}" },
          { name: "SshGroupListResult", declaration: "export type SshGroupListResult = SshResult<{ groups: SshGroupInfo[] }>;" },
          { name: "SshGroupSaveRequest", declaration: "export interface SshGroupSaveRequest { readonly groupId?: string; readonly name: string; }" },
          { name: "SshGroupSaveResult", declaration: "export type SshGroupSaveResult = SshResult<{ group: SshGroupInfo }>;" },
          { name: "SshGroupDeleteRequest", declaration: "export interface SshGroupDeleteRequest { readonly groupId: string; }" },
          { name: "SshGroupDeleteResult", declaration: "export type SshGroupDeleteResult = SshResult<{ deleted: boolean; movedProfiles: number }>;" },
          { name: "SshProfileInfo", declaration: "export interface SshProfileInfo { readonly profileId: string; readonly groupId: string | null; readonly groupName: string | null; readonly name: string; readonly host: string; readonly port: number; readonly username: string; readonly authKind: 'password' | 'key'; readonly credentialConfigured: boolean; readonly passphraseConfigured: boolean; readonly connected: boolean; readonly connectionId: string | null; }" },
          { name: "SshCredentialRefs", declaration: "export interface SshCredentialRefs { readonly password: string; readonly privateKey: string; readonly passphrase: string; }" },
          { name: "SshGroupInfo", declaration: "export interface SshGroupInfo { readonly groupId: string; readonly name: string; readonly profileCount: number; }" },
          { name: "SshDisconnectRequest", declaration: "export interface SshDisconnectRequest { readonly connectionId: string; }" },
          { name: "SshDisconnectResult", declaration: "export type SshDisconnectResult = SshResult<{ disconnected: boolean }>;" },
          { name: "SshSetActiveRequest", declaration: "export interface SshSetActiveRequest { readonly connectionId: string; }" },
          { name: "SshSetActiveResult", declaration: "export type SshSetActiveResult = SshResult<{ activeConnectionId: string }>;" }
        ]
      }
    ]
  }
};

export default TYPERT;
