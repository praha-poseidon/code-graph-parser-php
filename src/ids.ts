import { createHash } from "node:crypto";
import path from "node:path";
import type { RelationshipType } from "./model.js";

export function packageId(qualifiedName: string): string {
  return `pkg:${canonicalSymbol(qualifiedName)}`;
}

export function unitId(qualifiedName: string): string {
  return `unit:${canonicalSymbol(qualifiedName)}`;
}

export function functionId(qualifiedName: string): string {
  return `fn:${canonicalSymbol(qualifiedName)}`;
}

export function placeholderFunctionId(qualifiedName: string): string {
  return `placeholder:${functionId(qualifiedName)}`;
}

export function relationshipId(fromNodeId: string, type: RelationshipType, toNodeId: string): string {
  const identity = `${fromNodeId.trim()}|${type}|${toNodeId.trim()}`;
  return `rel:${createHash("sha1").update(identity).digest("hex")}`;
}

export function endpointId(direction: string, endpointType: string, matchIdentity: string): string {
  const identity = `${direction.trim()}:${endpointType.trim()}:${matchIdentity.trim()}`;
  return `endpoint:${direction.trim()}:${endpointType.trim()}:${createHash("sha1").update(identity).digest("hex")}`;
}

export function canonicalSymbol(value: string): string {
  return value.trim().replace(/^\\+/, "").replace(/\\+/g, "\\").toLowerCase();
}

export function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}
