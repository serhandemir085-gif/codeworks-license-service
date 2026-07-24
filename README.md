# CodeWorks License Server

Render Blueprint ile deploy edilir. `/health` servis kontrolü, `/v1/licenses/validate` müşteri doğrulaması, `/admin/api/licenses/generate` lisans üretimi ve `/admin/api/licenses/:key/revoke` iptal işlemi içindir.

Yönetim API isteklerinde `Authorization: Bearer ADMIN_KEY` kullanılır. `ADMIN_KEY` ve `TOKEN_SECRET` yalnızca Render Environment Variables içinde tutulmalıdır.
