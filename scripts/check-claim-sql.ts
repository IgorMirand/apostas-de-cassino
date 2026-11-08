import { MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../src/infra/orm.config';
import { MikroOrmUnitOfWork } from '../src/infra/persistence/repositories';

const orm = await MikroORM.init({ ...ormConfig, debug: ['query'] });
await new MikroOrmUnitOfWork(orm).run((repos) => repos.outbox.claimDue(new Date(), 5));
await orm.close();
