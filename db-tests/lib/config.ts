export type ServerConfig = { host: string; port: number; user: string; password: string };

/** The only hosts the database tests will ever connect to. */
export const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
