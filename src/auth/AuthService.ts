import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { AppDatabase } from "../db/Database.js";

export type UserRole = "admin" | "viewer";

export interface SessionUser {
  id: number;
  username: string;
  role: UserRole;
}

export interface ManagedUser extends SessionUser {
  createdAt: string;
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: SessionUser;
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class UserManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserManagementError";
  }
}

const DEFAULT_ADMIN_USERNAME = "admin";
const LEGACY_DEFAULT_ADMIN_PASSWORD = "ehSynchroAdmin";
const DEFAULT_ADMIN_PASSWORD = "ehSynchroAdmin2021!";
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
const PASSWORD_MIN_LENGTH = 8;
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;

export class AuthService {
  readonly sessionCookieName = "synchro_hrm_session";

  constructor(private readonly database: AppDatabase) {
    this.ensureDefaultAdmin();
  }

  login(username: string, password: string): LoginResult {
    const normalizedUsername = normalizeUsername(username);
    const normalizedPassword = normalizePassword(password);
    if (!normalizedUsername || !normalizedPassword) {
      throw new AuthenticationError("Username and password are required.");
    }

    const user = this.database.getUserByUsername(normalizedUsername);
    if (!user || !verifyPassword(normalizedPassword, String(user.password_hash ?? ""))) {
      throw new AuthenticationError("Invalid username or password.");
    }

    this.database.deleteExpiredSessions(new Date().toISOString());

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();
    this.database.createSession(token, Number(user.id), expiresAt);

    return {
      token,
      expiresAt,
      user: sanitizeUserRecord(user)
    };
  }

  logout(token: string | null | undefined): void {
    if (!token) {
      return;
    }

    this.database.deleteSession(token);
  }

  getSessionUser(token: string | null | undefined): SessionUser | null {
    if (!token) {
      return null;
    }

    const now = new Date().toISOString();
    this.database.deleteExpiredSessions(now);
    const user = this.database.getSessionUser(token, now);
    return user ? sanitizeUserRecord(user) : null;
  }

  listUsers(): ManagedUser[] {
    return this.database.listUsers().map((user) => ({
      ...sanitizeUserRecord(user),
      createdAt: String(user.created_at ?? "")
    }));
  }

  createViewer(username: string, password: string): ManagedUser {
    const normalizedUsername = normalizeUsername(username);
    const normalizedPassword = normalizePassword(password);

    if (!normalizedUsername || !USERNAME_PATTERN.test(normalizedUsername)) {
      throw new UserManagementError("Viewer usernames must be 3-32 characters using letters, numbers, dots, dashes, or underscores.");
    }
    assertPasswordIsLongEnough(normalizedPassword);
    if (this.database.getUserByUsername(normalizedUsername)) {
      throw new UserManagementError(`The username ${normalizedUsername} is already in use.`);
    }

    const userId = this.database.createUser(normalizedUsername, hashPassword(normalizedPassword), "viewer");
    const created = this.database.getUserById(userId);
    if (!created) {
      throw new UserManagementError("Viewer account could not be reloaded after creation.");
    }

    return {
      ...sanitizeUserRecord(created),
      createdAt: String(created.created_at ?? "")
    };
  }

  updateUserPassword(userId: number, password: string): ManagedUser {
    const user = this.database.getUserById(userId);
    if (!user) {
      throw new UserManagementError(`User ${userId} was not found.`);
    }

    const normalizedPassword = normalizePassword(password);
    assertPasswordIsLongEnough(normalizedPassword);

    this.database.updateUserPasswordHash(userId, hashPassword(normalizedPassword));
    const updated = this.database.getUserById(userId);
    if (!updated) {
      throw new UserManagementError(`User ${userId} could not be reloaded after the password update.`);
    }

    return {
      ...sanitizeUserRecord(updated),
      createdAt: String(updated.created_at ?? "")
    };
  }

  deleteViewer(userId: number): void {
    const user = this.database.getUserById(userId);
    if (!user) {
      throw new UserManagementError(`User ${userId} was not found.`);
    }
    if (user.role === "admin") {
      throw new AuthorizationError("Admin accounts cannot be removed from this interface.");
    }

    this.database.deleteUser(userId);
  }

  private ensureDefaultAdmin(): void {
    const existing = this.database.getUserByUsername(DEFAULT_ADMIN_USERNAME);
    if (existing) {
      const currentHash = String(existing.password_hash ?? "");
      if (
        verifyPassword(LEGACY_DEFAULT_ADMIN_PASSWORD, currentHash)
        && !verifyPassword(DEFAULT_ADMIN_PASSWORD, currentHash)
      ) {
        this.database.updateUserPasswordHash(Number(existing.id), hashPassword(DEFAULT_ADMIN_PASSWORD));
      }
      return;
    }

    this.database.createUser(DEFAULT_ADMIN_USERNAME, hashPassword(DEFAULT_ADMIN_PASSWORD), "admin");
  }
}

function sanitizeUserRecord(user: Record<string, unknown>): SessionUser {
  return {
    id: Number(user.id),
    username: String(user.username ?? ""),
    role: String(user.role ?? "viewer") as UserRole
  };
}

function normalizeUsername(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizePassword(value: string | null | undefined): string {
  return String(value ?? "");
}

function assertPasswordIsLongEnough(password: string): void {
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    throw new UserManagementError(`Passwords must be at least ${PASSWORD_MIN_LENGTH} characters long.`);
  }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const [scheme, salt, expectedHash] = encoded.split(":");
  if (scheme !== "scrypt" || !salt || !expectedHash) {
    return false;
  }

  const actualHash = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expectedHash, "hex");
  if (actualHash.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualHash, expectedBuffer);
}
