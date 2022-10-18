'use strict'

const debug = require('debug')('gtfs-via-postgres')
const sequencify = require('sequencify')
const {inspect} = require('util')
const readCsv = require('gtfs-utils/read-csv')
const {Stringifier} = require('csv-stringify')
const formatters = require('./lib')
const getDependencies = require('./lib/deps')
const pkg = require('./package.json')

const convertGtfsToSql = async function* (files, opt = {}) {
	opt = {
		silent: false,
		requireDependencies: false,
		ignoreUnsupportedFiles: false,
		tripsWithoutShapeId: false,
		routesWithoutAgencyId: false,
		stopsWithoutLevelId: !files.some(f => f.name === 'levels'),
		stopsLocationIndex: false,
		schema: 'public',
		postgraphile: false,
		...opt,
	}
	debug('opt', opt)
	const {
		silent,
		tripsWithoutShapeId,
		requireDependencies,
		ignoreUnsupportedFiles,
	} = opt

	if (ignoreUnsupportedFiles) {
		files = files.filter(f => !!formatters[f.name])
	}
	debug('files', files)

	const fileNames = files.map(f => f.name)
	const deps = getDependencies(opt, fileNames)
	debug('deps', deps)

	const tasks = { // file name -> [dep name]
		'is_bcp_47_code': {
			dep: [],
		},
		'is_timezone': {
			dep: [],
		},
		...(tripsWithoutShapeId ? {} : {
			'shape_exists': {
				dep: [...deps.shape_exists],
			},
		}),

		// special handling of calendar/calendar_dates:
		// service_days relies on *both* calendar's & calendar_dates' tables to
		// be present, so we add mock tasks here. Each of these mock tasks get
		// replaced by a file-based one below if the file has been passed.
		'calendar': {
			dep: [],
		},
		'calendar_dates': {
			dep: [],
		},
		'service_days': {
			dep: ['calendar', 'calendar_dates'],
		},

		// The arrivals_departures & connections views rely on frequencies' table
		// to be present, so we add a mock task here. It gets replaced by a
		// file-based on below if the file has been passed.
		'frequencies': {
			dep: [...deps.frequencies],
		},
	}

	for (const file of files) {
		if (!formatters[file.name]) {
			throw new Error('invalid/unsupported file: ' + file.name)
		}

		const dependencies = deps[file.name] || []
		for (const dep of dependencies) {
			if (requireDependencies && !tasks[dep] && !fileNames.includes(dep)) {
				const err = new Error(`${file.name} depends on ${dep}`)
				err.code = 'MISSING_GTFS_DEPENDENCY'
				throw err
			}
		}

		tasks[file.name] = {
			file: file.file,
			dep: Array.from(dependencies),
		}
	}
	debug('tasks', tasks)

	const order = []
	sequencify(tasks, Object.keys(tasks), order)
	debug('order', order)

	yield `\
-- GTFS SQL dump generated by ${pkg.name} v${pkg.version}
-- ${pkg.homepage}
-- options:
${inspect(opt, {compact: false}).split('\n').map(line => '-- ' + line).join('\n')}

\\set ON_ERROR_STOP True
CREATE EXTENSION IF NOT EXISTS postgis;
${opt.schema !== 'public' ? `CREATE SCHEMA IF NOT EXISTS "${opt.schema}";` : ''}
BEGIN;

\n`

	const csv = new Stringifier({quoted: true})

	for (const name of order) {
		if (!silent) console.error(name)
		const task = tasks[name]
		yield `-- ${name}\n-----------------\n\n`

		const {
			beforeAll,
			afterAll,
		} = formatters[name]

		if ('string' === typeof beforeAll && beforeAll) {
			yield beforeAll
		} else if ('function' === typeof beforeAll) {
			yield beforeAll(opt)
		}

		if (task.file) {
			const {formatRow} = formatters[name]
			for await (const rawRow of await readCsv(task.file)) {
				const row = formatRow(rawRow, opt)
				let formattedRow = null
				csv.api.__transform(row, (_formattedRow) => {
					formattedRow = _formattedRow
				})
				yield formattedRow
			}
		}

		if ('string' === typeof afterAll && afterAll) {
			yield afterAll + ';\n'
		} else if ('function' === typeof afterAll) {
			yield afterAll(opt) + ';\n'
		}
	}

	yield `\

${opt.postgraphile ? `\
-- seal imported data
-- todo:
-- > Be careful with public schema.It already has a lot of default privileges that you maybe don't want... See documentation[1].
-- > [1]: postgresql.org/docs/11/ddl-schemas.html#DDL-SCHEMAS-PRIV
DO $$
BEGIN
	-- https://stackoverflow.com/questions/8092086/create-postgresql-role-user-if-it-doesnt-exist#8099557
	IF EXISTS (
		SELECT FROM pg_catalog.pg_roles
		WHERE rolname = 'postgraphile'
	) THEN
		RAISE NOTICE 'Role "postgraphile" already exists, skipping creation.';
	ELSE
		CREATE ROLE postgraphile LOGIN PASSWORD 'todo'; -- todo: postgraphile password?
	END IF;
END
$$;
DO $$
    DECLARE
        db TEXT := current_database();
    BEGIN
        EXECUTE format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', db, 'postgraphile');
    END
$$;
GRANT USAGE ON SCHEMA "${opt.schema}" TO postgraphile;
-- https://stackoverflow.com/questions/760210/how-do-you-create-a-read-only-user-in-postgresql#comment50679407_762649
REVOKE CREATE ON SCHEMA "${opt.schema}" FROM PUBLIC;
GRANT SELECT ON ALL TABLES IN SCHEMA "${opt.schema}" TO postgraphile;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA "${opt.schema}" GRANT SELECT ON TABLES TO postgraphile;
-- todo: set search_path? https://stackoverflow.com/questions/760210/how-do-you-create-a-read-only-user-in-postgresql#comment33535263_762649
` : ''}

COMMIT;`
}

module.exports = convertGtfsToSql
