import { caching, Storage } from 'cache-manager';
import { proto } from '../../WAProto';
import { AuthenticationCreds } from '../Types';
import { BufferJSON, initAuthCreds } from '../Utils';
import logger from '../Utils/logger';

const makeCacheManagerAuthState = async (store: Storage, sessionKey: string) => {
	const defaultKey = (file: string): string => `${sessionKey}:${file}`;
	const databaseConn = await caching(store);

	const writeData = async (file: string, data: object) => {
		const ttl = file === 'creds' ? 63115200 : undefined; // 2 years
		const jsonData = JSON.stringify(data, BufferJSON.replacer);
		await databaseConn.set(defaultKey(file), jsonData, ttl);
	};

	const readData = async (file: string): Promise<AuthenticationCreds | null> => {
		try {
			const data = await databaseConn.get(defaultKey(file));
			if (data) {
				return JSON.parse(data as string, BufferJSON.reviver);
			}
			return null;
		} catch (error) {
			logger.error(error);
			return null;
		}
	};

	const removeData = async (file: string) => {
		try {
			await databaseConn.del(defaultKey(file));
		} catch (error) {
			logger.error(`Error removing ${file} from session ${sessionKey}: ${error}`);
		}
	};

	const clearState = async () => {
		try {
			const keys = await databaseConn.store.keys(`${sessionKey}*`);
			await Promise.all(keys.map((key) => databaseConn.del(key)));
		} catch (error) {
			logger.error(`Error clearing state for session ${sessionKey}: ${error}`);
		}
	};

	const creds: AuthenticationCreds = (await readData('creds')) || initAuthCreds();

	return {
		clearState,
		saveCreds: async () => {
			await writeData('creds', creds);
		},
		state: {
			creds,
			keys: {
				get: async (type: string, ids: string[]) => {
					const data: Record<string, proto.Message.AppStateSyncKeyData | AuthenticationCreds | null> = {};
					await Promise.all(
						ids.map(async (id) => {
							let value: proto.Message.AppStateSyncKeyData | AuthenticationCreds | null = await readData(`${type}-${id}`);
							if (type === 'app-state-sync-key' && value) {
								value = proto.Message.AppStateSyncKeyData.fromObject(value);
							}
							data[id] = value;
						})
					);
					return data;
				},
				set: async (data: Record<string, Record<string, object | null>>) => {
					const tasks = Object.entries(data).flatMap(([category, entries]) =>
						Object.entries(entries).map(([id, value]) => {
							const key = `${category}-${id}`;
							if (value) {
								return writeData(key, value);
							} else {
								return removeData(key);
							}
						})
					);
					await Promise.all(tasks);
				},
			},
		},
	};
};

export default makeCacheManagerAuthState;
