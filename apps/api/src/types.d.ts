import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string; email: string; role: string; shopId?: string };
    rawBody?: string;
  }
}
