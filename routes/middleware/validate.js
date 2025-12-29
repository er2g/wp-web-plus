const { ZodError } = require('zod');
const { sendError } = require('../../lib/httpResponses');

function formatIssues(issues, limit = 10) {
    const sliced = Array.isArray(issues) ? issues.slice(0, limit) : [];
    return sliced.map((issue) => ({
        path: Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join('.') : null,
        message: issue.message,
        code: issue.code
    }));
}

function validate({ body, query, params } = {}) {
    return (req, res, next) => {
        try {
            if (params) {
                req.validatedParams = params.parse(req.params);
            }
            if (query) {
                req.validatedQuery = query.parse(req.query);
            }
            if (body) {
                req.validatedBody = body.parse(req.body);
            }
            return next();
        } catch (error) {
            if (error instanceof ZodError) {
                const issues = formatIssues(error.issues);
                const firstMessage = issues[0]?.message || 'Validation error';
                return sendError(req, res, 400, firstMessage, { issues });
            }
            return next(error);
        }
    };
}

module.exports = {
    validate
};

