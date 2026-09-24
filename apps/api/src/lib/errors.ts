/** Contrato de erro consistente: código, mensagem e ID de requisição (R33-04). */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new HttpError(400, code, message, details);
export const unauthorized = (message = "Autenticação necessária") => new HttpError(401, "unauthorized", message);
export const forbidden = (code = "forbidden", message = "Sem permissão para esta ação") => new HttpError(403, code, message);
export const notFound = (message = "Recurso não encontrado") => new HttpError(404, "not_found", message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const tooMany = (message = "Muitas tentativas. Aguarde alguns minutos.") => new HttpError(429, "rate_limited", message);
