import {
    SiMysql, SiMariadb, SiPostgresql, SiSqlite, SiMongodb, SiRedis, SiDocker,
} from 'react-icons/si';

// engine key -> brand icon component. Keys match ENGINE_META / node.engine.
export const ENGINE_ICONS = {
    mysql: SiMysql,
    mariadb: SiMariadb,
    postgresql: SiPostgresql,
    sqlite: SiSqlite,
    mongodb: SiMongodb,
    redis: SiRedis,
    docker: SiDocker,
};

export function hasBrandIcon(engine) {
    return Boolean(ENGINE_ICONS[engine]);
}
