/**
 * UserStore — Phase 24 user + per-module role management.
 *
 * Email is the natural key from the operator's perspective. Internally
 * we use a UUID id. Disabled users keep their row (audit) but can't
 * authenticate; ``findByEmail`` excludes them.
 *
 * Roles live in ``vs_user_roles`` keyed by (user_id, module). Granting
 * a role is an upsert on that PK so re-granting the same role is a
 * no-op. ``is_org_admin`` is an independent superuser bit on the user
 * row and bypasses every role check.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { users } from '../schema/users.js';
import { userRoles } from '../schema/user-roles.js';

export type Module = 'redact' | 'scan' | 'compliance';
export type Role = 'viewer' | 'operator' | 'admin';

export interface UserRecord {
  id: string;
  email: string;
  isOrgAdmin: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
  disabledAt: Date | null;
}

export interface UserWithRoles extends UserRecord {
  roles: Partial<Record<Module, Role>>;
}

export interface CreateUserInput {
  email: string;
  isOrgAdmin?: boolean;
}

const ROLE_RANK: Record<Role, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

/** True iff ``actual`` is at or above ``minimum``. */
export function roleSatisfies(actual: Role, minimum: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[minimum];
}

export class UserExistsError extends Error {
  override readonly name = 'UserExistsError';
}

export class UserNotFoundError extends Error {
  override readonly name = 'UserNotFoundError';
}

export class UserStore {
  constructor(private readonly db: Database) {}

  /** Create a user. Throws ``UserExistsError`` on duplicate-active email. */
  async create(input: CreateUserInput): Promise<UserRecord> {
    const normalized = input.email.trim().toLowerCase();
    try {
      const [row] = await this.db
        .insert(users)
        .values({
          email: normalized,
          isOrgAdmin: input.isOrgAdmin ?? false,
        })
        .returning();
      if (row === undefined) {
        throw new Error('insert returned no rows');
      }
      return toRecord(row);
    } catch (err) {
      // Postgres unique_violation = 23505 — our index is partial on the
      // active set, so we only throw on collisions with non-disabled
      // rows.
      if (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: string }).code === '23505'
      ) {
        throw new UserExistsError(`user with email ${normalized} already exists`);
      }
      throw err;
    }
  }

  async findById(id: string): Promise<UserRecord | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /** Email lookup. Disabled users are excluded by design. */
  async findByEmail(email: string): Promise<UserRecord | null> {
    const normalized = email.trim().toLowerCase();
    const rows = await this.db
      .select()
      .from(users)
      .where(and(sql`LOWER(${users.email}) = ${normalized}`, isNull(users.disabledAt)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /** Hydrate a user with their per-module role map. */
  async findByIdWithRoles(id: string): Promise<UserWithRoles | null> {
    const user = await this.findById(id);
    if (user === null) return null;
    const roleRows = await this.db
      .select()
      .from(userRoles)
      .where(eq(userRoles.userId, id));
    const roles: Partial<Record<Module, Role>> = {};
    for (const r of roleRows) {
      roles[r.module as Module] = r.role as Role;
    }
    return { ...user, roles };
  }

  async listAll(): Promise<UserWithRoles[]> {
    const userRows = await this.db.select().from(users);
    const roleRows = await this.db.select().from(userRoles);
    const byUser = new Map<string, Partial<Record<Module, Role>>>();
    for (const r of roleRows) {
      const m = byUser.get(r.userId) ?? {};
      m[r.module as Module] = r.role as Role;
      byUser.set(r.userId, m);
    }
    return userRows.map((u) => ({
      ...toRecord(u),
      roles: byUser.get(u.id) ?? {},
    }));
  }

  /**
   * Set the user's role on ``module``. Upsert: granting an existing
   * role is a no-op; granting a different role replaces the prior one.
   */
  async setRole(userId: string, module: Module, role: Role): Promise<void> {
    await this.db
      .insert(userRoles)
      .values({ userId, module, role })
      .onConflictDoUpdate({
        target: [userRoles.userId, userRoles.module],
        set: { role },
      });
  }

  async revokeRole(userId: string, module: Module): Promise<void> {
    await this.db
      .delete(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.module, module)));
  }

  async setOrgAdmin(userId: string, value: boolean): Promise<void> {
    await this.db
      .update(users)
      .set({ isOrgAdmin: value })
      .where(eq(users.id, userId));
  }

  async disable(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, userId));
  }

  async markLogin(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, userId));
  }

  /** Used by bootstrap to detect the empty-table case. */
  async count(): Promise<number> {
    const rows = await this.db.select({ id: users.id }).from(users);
    return rows.length;
  }
}

function toRecord(row: typeof users.$inferSelect): UserRecord {
  return {
    id: row.id,
    email: row.email,
    isOrgAdmin: row.isOrgAdmin,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    disabledAt: row.disabledAt,
  };
}
